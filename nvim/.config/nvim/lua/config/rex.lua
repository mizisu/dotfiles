local M = {}

function M.active()
  return vim.env.REX_SESSION ~= nil and vim.env.REX_BLOCK ~= nil and not vim.env.TMUX
end

function M.call(method, args)
  args.session_id = vim.env.REX_SESSION
  local result = vim.system({ "rex", "--autostart=false", "--timeout", "3s", "api", "call", method, "-" },
    { text = true, stdin = vim.json.encode(args) }):wait(4000)
  if result.code ~= 0 then
    local message = vim.trim((result.stderr ~= "" and result.stderr or result.stdout) or "")
    error(message ~= "" and message or ("Rex " .. method .. " failed"))
  end
  return vim.json.decode(result.stdout)
end

function M.navigate(direction, key)
  local before = vim.api.nvim_get_current_win()
  vim.cmd.wincmd(key)
  if before ~= vim.api.nvim_get_current_win() then return end
  if not M.active() or vim.fn.executable("rex") ~= 1 then return end
  local command = {
    "rex", "--autostart=false", "--timeout", "3s", "do", "navigate",
    "-s", vim.env.REX_SESSION, "-b", vim.env.REX_BLOCK, "direction=" .. direction,
  }
  local result = vim.system(command, { text = true }):wait(3000)
  if result.code ~= 0 then vim.notify(result.stderr, vim.log.levels.WARN) end
end

-- A nested editor must not take over the outer editor's per-pane RPC address.
function M.register_server()
  if not M.active() then return end
  local id = vim.env.REX_BLOCK:match("^block:([%x-]+)$")
  if not id then return end
  local directory = vim.fn.expand("~/.cache/nvim")
  vim.fn.mkdir(directory, "p", 448)
  local socket = directory .. "/rex-" .. id .. ".pipe"
  for _, address in ipairs(vim.fn.serverlist()) do
    if address == socket then return end
  end
  local ok, err = pcall(vim.fn.serverstart, socket)
  if not ok then vim.notify("Rex RPC: " .. tostring(err), vim.log.levels.WARN) end
end

-- An external lazygit popup should get out of the way after its edit command.
function M.reveal_editor()
  if not M.active() then return end
  local call = M.call
  local ok, err = pcall(function()
    local view = call("session.view", {})
    for _, window in ipairs(view.windows or {}) do
      local contains_editor = false
      local popup
      for _, layer in ipairs(window.layers or {}) do
        for _, block in ipairs(layer.blocks or {}) do
          if block.block_id == vim.env.REX_BLOCK then contains_editor = true end
          if block.block_id == window.focused_block_id and (block.label or ""):match("^pi%-popup:.*:lazygit$") then
            popup = block.block_id
          end
        end
      end
      if contains_editor and popup and popup ~= vim.env.REX_BLOCK then
        call("session.detach_block", { block_id = popup })
        call("session.focus_block", { block_id = vim.env.REX_BLOCK })
      end
    end
  end)
  if not ok then vim.notify(tostring(err), vim.log.levels.WARN) end
end

return M
