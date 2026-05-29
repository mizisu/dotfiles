local M = {}

local CLIENT_NAME = "ty-workspace-symbols"
local METHOD = "workspace/symbol"
local uv = vim.uv or vim.loop

local DEFAULT_KIND_FILTER = {
  default = {
    "Class",
    "Constructor",
    "Enum",
    "Field",
    "Function",
    "Interface",
    "Method",
    "Module",
    "Namespace",
    "Package",
    "Property",
    "Struct",
    "Trait",
  },
}

local last_error = nil

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = "ty workspace symbols" })
end

local function notify_once(message, level)
  if last_error == message then
    return
  end
  last_error = message
  notify(message, level)
end

local function ty_executable()
  local executable = vim.fn.exepath("ty")
  if executable ~= "" then
    return executable
  end

  local mason_ty = vim.fn.stdpath("data") .. "/mason/bin/ty"
  if uv.fs_stat(mason_ty) then
    return mason_ty
  end
end

local function root_dir(buf)
  if _G.LazyVim and LazyVim.root then
    local ok, root = pcall(LazyVim.root, { buf = buf, normalize = true })
    if ok and root and root ~= "" then
      return root
    end
  end

  local root = vim.fs.root(buf, {
    "ty.toml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    ".git",
  })
  if root then
    return vim.fs.normalize(root)
  end

  local name = vim.api.nvim_buf_get_name(buf)
  if name ~= "" then
    return vim.fs.dirname(name)
  end

  return uv.cwd()
end

local function kind_filter()
  if _G.LazyVim and LazyVim.config and LazyVim.config.kind_filter ~= false then
    return LazyVim.config.kind_filter or DEFAULT_KIND_FILTER
  end

  return DEFAULT_KIND_FILTER
end

local function find_client(root)
  for _, client in ipairs(vim.lsp.get_clients({ name = CLIENT_NAME })) do
    if client.root_dir and vim.fs.normalize(client.root_dir) == root then
      return client
    end
  end
end

local function start_client(buf)
  if vim.bo[buf].filetype ~= "python" then
    notify("ty workspace symbols are only enabled for Python buffers", vim.log.levels.WARN)
    return nil
  end

  local executable = ty_executable()
  if not executable then
    notify("ty executable not found. Install it with :MasonInstall ty", vim.log.levels.ERROR)
    return nil
  end

  local root = root_dir(buf)
  local client = find_client(root)
  if client then
    return client
  end

  local id = vim.lsp.start({
    name = CLIENT_NAME,
    cmd = { executable, "server" },
    root_dir = root,
    settings = {
      ty = {
        diagnosticMode = "off",
      },
    },
    handlers = {
      ["textDocument/publishDiagnostics"] = function() end,
    },
    on_init = function(client)
      local workspace_symbol_provider = client.server_capabilities.workspaceSymbolProvider
      client.server_capabilities = {
        workspaceSymbolProvider = workspace_symbol_provider or true,
      }
    end,
  }, { attach = false, silent = true })

  if not id then
    notify("failed to start ty language server", vim.log.levels.ERROR)
    return nil
  end

  return vim.lsp.get_client_by_id(id)
end

local function wait_until_initialized(client, ctx)
  local waited = 0
  while client and not client.initialized and waited < 5000 and not ctx.async:aborted() do
    ctx.async:sleep(50)
    waited = waited + 50
  end

  return client and client.initialized
end

local function request_symbols(client, buf, query, ctx)
  if not wait_until_initialized(client, ctx) then
    return nil, "timed out while starting ty language server"
  end

  if not client:supports_method(METHOD) then
    return nil, "ty language server does not support workspace symbols"
  end

  local done = false
  local request_error = nil
  local response = nil

  local ok, request_id = ctx.async:schedule(function()
    return client:request(METHOD, { query = query }, function(err, result)
      vim.schedule(function()
        request_error = err
        response = result
        done = true
        ctx.async:resume()
      end)
    end, buf)
  end)

  if not ok then
    return nil, "failed to request ty workspace symbols"
  end

  ctx.async:on("abort", function()
    if request_id then
      vim.schedule(function()
        client:cancel_request(request_id)
      end)
    end
  end)

  while not done and not ctx.async:aborted() do
    ctx.async:suspend()
  end

  if ctx.async:aborted() then
    return nil, nil
  end

  if request_error then
    return nil, request_error.message or tostring(request_error)
  end

  return response or {}, nil
end

local function resolve_filter(filter, filetype)
  if filter == nil then
    return nil
  end

  if type(filter) ~= "table" then
    return filter
  end

  local filetype_filter = filter[filetype]
  if filetype_filter == nil then
    return filter.default
  end

  return filetype_filter
end

local function symbol_rank(query, name)
  local q = vim.trim(query):lower()
  local n = name:lower()

  if n == q then
    return 0
  end
  if n:sub(1, #q) == q then
    return 1
  end
  if n:find(q, 1, true) then
    return 2
  end
  return 3
end

local function finder(opts, ctx)
  local client = opts.ty_client
  local buf = opts.bufnr or ctx.filter.current_buf
  local lsp_source = require("snacks.picker.source.lsp")
  local bufmap = lsp_source.bufmap()
  local symbol_filter = resolve_filter(opts.kind_filter, vim.bo[buf].filetype)

  local function want(kind)
    if symbol_filter == nil then
      return true
    end
    if type(symbol_filter) == "boolean" then
      return symbol_filter
    end
    return vim.tbl_contains(symbol_filter, kind)
  end

  return function(cb)
    local query = ctx.filter.search or ""
    if query == "" then
      return
    end

    local results, err = request_symbols(client, buf, query, ctx)
    if err then
      notify_once(err, vim.log.levels.WARN)
      return
    end
    if not results then
      return
    end

    local ok, items = pcall(lsp_source.results_to_items, client, results, {
      text_with_file = true,
      filter = function(item)
        return want(lsp_source.symbol_kind(item.kind))
      end,
    })

    if not ok then
      notify_once("failed to parse ty workspace symbols", vim.log.levels.ERROR)
      return
    end

    local seen = {}
    for _, item in ipairs(items) do
      local name = item.name or item.text
      local pos = item.pos or {}
      local key = table.concat({ name, item.file or "", pos[1] or "", pos[2] or "" }, ":")
      if not seen[key] then
        seen[key] = true
        item.tree = false
        item.buf = bufmap[item.file]
        item.ty_rank = symbol_rank(query, name)
        item.ty_name_len = #name
        item.ty_name_lower = name:lower()
        cb(item)
      end
    end
  end
end

function M.open()
  local buf = vim.api.nvim_get_current_buf()
  local client = start_client(buf)
  if not client then
    return
  end

  last_error = nil

  require("snacks").picker.pick({
    source = "ty_workspace_symbols",
    title = "Ty Workspace Symbols",
    finder = finder,
    format = "lsp_symbol",
    preview = "file",
    workspace = true,
    live = true,
    supports_live = true,
    cwd = root_dir(buf),
    bufnr = buf,
    ty_client = client,
    kind_filter = kind_filter(),
    matcher = { sort_empty = true },
    sort = { fields = { "ty_rank", "ty_name_len", "ty_name_lower", "idx" } },
    jump = { tagstack = true, reuse_win = true },
  })
end

return M
