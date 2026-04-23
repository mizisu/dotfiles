local function run(args)
  local result = vim.system(args, { text = true }):wait()
  if result.code == 0 then
    return vim.trim(result.stdout)
  end

  local message = vim.trim(result.stderr ~= "" and result.stderr or result.stdout)
  if message == "" then
    message = table.concat(args, " ")
  end
  return nil, message
end

local function buffer_path()
  local absolute_path = vim.api.nvim_buf_get_name(0)
  if absolute_path == "" then
    vim.notify("Current buffer has no file path", vim.log.levels.ERROR)
    return nil
  end

  local dir = vim.fn.fnamemodify(absolute_path, ":h")
  local git_root = run({ "git", "-C", dir, "rev-parse", "--show-toplevel" })
  if git_root and vim.startswith(absolute_path, git_root .. "/") then
    return absolute_path:sub(#git_root + 2)
  end

  return vim.fn.fnamemodify(absolute_path, ":.")
end

local function target_pane()
  if vim.env.TMUX == nil or vim.env.TMUX == "" or vim.env.TMUX_PANE == nil or vim.env.TMUX_PANE == "" then
    return nil, "Not running inside tmux"
  end

  local window_id, err = run({ "tmux", "display-message", "-p", "-t", vim.env.TMUX_PANE, "#{window_id}" })
  if not window_id then
    return nil, err
  end

  local output
  output, err = run({ "tmux", "list-panes", "-t", window_id, "-F", "#{pane_id}\t#{pane_last}\t#{pane_dead}" })
  if not output then
    return nil, err
  end

  local candidates = {}
  local last_candidates = {}
  for line in vim.gsplit(output, "\n", { plain = true, trimempty = true }) do
    local pane_id, pane_last, pane_dead = line:match("([^\t]+)\t([^\t]+)\t([^\t]+)")
    if pane_id and pane_id ~= vim.env.TMUX_PANE and pane_dead == "0" then
      table.insert(candidates, pane_id)
      if pane_last == "1" then
        table.insert(last_candidates, pane_id)
      end
    end
  end

  if #candidates == 1 then
    return candidates[1]
  end

  if #last_candidates == 1 then
    return last_candidates[1]
  end

  return nil, "Could not determine target pane in the current tmux window"
end

local function send_to_pi(reference)
  if not reference then
    return
  end

  reference = reference .. " "

  local pane_id, err = target_pane()
  if not pane_id then
    vim.notify(err, vim.log.levels.ERROR)
    return
  end

  local buf_name = string.format("pi_send_%d", vim.fn.getpid())
  local _, message = run({ "tmux", "set-buffer", "-b", buf_name, "--", reference })
  if message ~= nil then
    vim.notify(message, vim.log.levels.ERROR)
    return
  end

  local pane_in_mode = run({ "tmux", "display-message", "-p", "-t", pane_id, "#{pane_in_mode}" })
  if pane_in_mode == "1" then
    run({ "tmux", "send-keys", "-t", pane_id, "-X", "cancel" })
  end

  _, message = run({ "tmux", "paste-buffer", "-p", "-d", "-b", buf_name, "-t", pane_id })
  if message ~= nil then
    vim.notify(message, vim.log.levels.ERROR)
    return
  end

  _, message = run({ "tmux", "select-pane", "-t", pane_id })
  if message ~= nil then
    vim.notify(message, vim.log.levels.ERROR)
  end
end

local function visual_reference()
  local path = buffer_path()
  if not path then
    return nil
  end

  local start_line = vim.fn.getpos("'<")[2]
  local end_line = vim.fn.getpos("'>")[2]
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  if start_line == end_line then
    return string.format("%s:L%d", path, start_line)
  end

  return string.format("%s:L%d-L%d", path, start_line, end_line)
end

vim.keymap.set("n", "<leader>a", function()
  send_to_pi(buffer_path())
end, { desc = "Send file path to pi" })

vim.keymap.set("x", "<leader>a", function()
  send_to_pi(visual_reference())
end, { desc = "Send line reference to pi" })

return {}
