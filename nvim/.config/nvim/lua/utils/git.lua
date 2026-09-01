local M = {}

local function command_output(result, args)
  if result.code == 0 then
    return vim.trim(result.stdout or "")
  end

  local message = vim.trim(result.stderr or "")
  if message == "" then
    message = vim.trim(result.stdout or "")
  end
  if message == "" and result.code == 124 then
    message = "Command timed out"
  end
  return nil, message ~= "" and message or table.concat(args, " ")
end

local function run(args, cwd)
  local ok, result = pcall(function()
    return vim.system(args, { cwd = cwd, text = true }):wait()
  end)
  if not ok then
    return nil, tostring(result)
  end
  return command_output(result, args)
end

local function run_async(args, opts, callback)
  opts = vim.tbl_extend("force", { text = true }, opts or {})
  local ok, system_err = pcall(function()
    vim.system(args, opts, function(result)
      vim.schedule(function()
        callback(command_output(result, args))
      end)
    end)
  end)

  if not ok then
    vim.schedule(function()
      callback(nil, tostring(system_err))
    end)
  end
end

function M.get_repo_root(bufnr)
  local path = vim.api.nvim_buf_get_name(bufnr or 0)
  local cwd = path ~= "" and vim.fs.dirname(path) or vim.fn.getcwd()
  if not cwd or vim.fn.isdirectory(cwd) == 0 then
    cwd = vim.fn.getcwd()
  end

  return run({ "git", "rev-parse", "--show-toplevel" }, cwd)
end

function M.is_git_repo()
  return M.get_repo_root() ~= nil
end

local function parse_repository_url(url)
  url = vim.trim(url or "")

  local authority, path = url:match("^%a[%w+.-]*://([^/]+)/(.+)$")
  local host
  if authority then
    host = authority:match("@(.+)$") or authority
  else
    host, path = url:match("^[^@]+@([^:]+):(.+)$")
    if not host then
      host, path = url:match("^([^/:]+):(.+)$")
    end
  end

  if not host or not path then
    return nil, nil
  end

  path = path:gsub("[?#].*$", ""):gsub("/+$", ""):gsub("%.git$", "")
  return host:lower(), path:lower()
end

local function find_remote(repo_root, repository_url)
  local target_host, target_path = parse_repository_url(repository_url)
  if not target_host then
    return nil, "Could not identify the PR base repository"
  end

  local output, err = run({ "git", "remote" }, repo_root)
  if not output then
    return nil, err
  end

  local path_matches = {}
  for remote in vim.gsplit(output, "\n", { plain = true, trimempty = true }) do
    local remote_urls = run({ "git", "config", "--get-all", "remote." .. remote .. ".url" }, repo_root) or ""
    local path_matched = false
    for remote_url in vim.gsplit(remote_urls, "\n", { plain = true, trimempty = true }) do
      local remote_host, remote_path = parse_repository_url(remote_url)
      if remote_path == target_path then
        if remote_host == target_host then
          return remote
        end
        path_matched = true
      end
    end
    if path_matched then
      table.insert(path_matches, remote)
    end
  end

  if #path_matches == 1 then
    return path_matches[1]
  end
  if #path_matches > 1 then
    return nil, string.format("Multiple Git remotes match PR base repository '%s'", repository_url)
  end
  return nil, string.format("No Git remote matches PR base repository '%s'", repository_url)
end

function M.get_pr_base(repo_root, callback)
  repo_root = repo_root or M.get_repo_root()
  if not repo_root then
    vim.schedule(function()
      callback(nil, "Current buffer is not in a Git repository")
    end)
    return
  end

  local args = {
    "gh",
    "pr",
    "view",
    "--json",
    "baseRefName,baseRefOid,url",
    "--jq",
    "[.baseRefName, .baseRefOid, .url] | @tsv",
  }
  run_async(args, { cwd = repo_root, timeout = 30000 }, function(output, err)
    if not output then
      callback(nil, err)
      return
    end

    local base_name, base_oid, pr_url = output:match("^([^\t]+)\t([0-9a-fA-F]+)\t([^\t]+)$")
    local repository_url = pr_url and pr_url:match("^(.-)/pull/%d+")
    if not base_name or not base_oid or not repository_url then
      callback(nil, "Could not read the PR base ref")
      return
    end

    callback({
      name = base_name,
      oid = base_oid,
      repository_url = repository_url,
    })
  end)
end

function M.has_commit(repo_root, oid)
  local _, err = run({ "git", "cat-file", "-e", oid .. "^{commit}" }, repo_root)
  return err == nil
end

function M.fetch_pr_base(repo_root, base, callback)
  local remote, remote_err = find_remote(repo_root, base.repository_url)
  if not remote then
    vim.schedule(function()
      callback(remote_err)
    end)
    return
  end

  local source = "refs/heads/" .. base.name
  local destination = "refs/remotes/" .. remote .. "/" .. base.name
  local refspec = "+" .. source .. ":" .. destination
  local args = { "git", "fetch", "--no-tags", "--no-write-fetch-head", "--", remote, refspec }

  run_async(args, {
    cwd = repo_root,
    env = { GIT_TERMINAL_PROMPT = "0" },
    timeout = 60000,
  }, function(_, fetch_err)
    if fetch_err then
      callback(string.format("Failed to fetch PR base from '%s': %s", remote, fetch_err))
      return
    end
    if not M.has_commit(repo_root, base.oid) then
      callback(string.format("Fetched '%s', but PR base commit %s is still unavailable", remote, base.oid))
      return
    end
    callback(nil, remote)
  end)
end

return M