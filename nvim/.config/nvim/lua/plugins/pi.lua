local function buffer_path()
  local absolute_path = vim.api.nvim_buf_get_name(0)
  if absolute_path == "" then
    vim.notify("Current buffer has no file path", vim.log.levels.ERROR)
    return nil
  end

  return vim.fn.fnamemodify(absolute_path, ":p")
end

local function send_to_rex(reference)
  local call = require("config.rex").call

  local ok, err = pcall(function()
    local blocks = call("session.list_blocks", {}).blocks or {}
    local window
    for _, block in ipairs(blocks) do
      if block.block_id == vim.env.REX_BLOCK then window = block.window_id end
    end
    assert(window, "Current Rex pane is not placed in a window")
    local candidates = {}
    for _, block in ipairs(blocks) do
      if block.window_id == window and block.block_id ~= vim.env.REX_BLOCK then
        local process = call("com.superlogical.terminal.process", { block_id = block.block_id, args = vim.empty_dict() })
        local status = call("com.superlogical.terminal.program_status", { block_id = block.block_id, args = vim.empty_dict() })
        for _, record in ipairs(status.records or {}) do
          if (record.app == "pi" or record.effective_app == "pi") and process.foreground
            and record.owner and record.owner.pid == process.foreground.pid then
            candidates[#candidates + 1] = { id = block.block_id, title = record.msg or block.label }
            break
          end
        end
      end
    end
    assert(#candidates > 0, "No active Pi found in the current Rex tab")
    local function paste(target)
      if not target then return end
      local sent, message = pcall(function()
        call("block.event", { block_id = target.id, event = { type = "paste", payload = { text = reference } } })
        call("session.focus_block", { block_id = target.id })
      end)
      if not sent then vim.notify(tostring(message), vim.log.levels.ERROR) end
    end
    if #candidates == 1 then paste(candidates[1])
    else
      vim.ui.select(candidates, {
        prompt = "Send to Pi (no Enter):",
        format_item = function(item) return item.title .. " [" .. item.id:sub(-6) .. "]" end,
      }, paste)
    end
  end)
  if not ok then vim.notify(tostring(err), vim.log.levels.ERROR) end
end

local function send_to_pi(reference, append_space)
  if not reference then
    return
  end

  if append_space ~= false then
    reference = reference .. " "
  end

  if not require("config.rex").active() then
    vim.notify("Sending to Pi requires Rex", vim.log.levels.ERROR)
    return
  end

  send_to_rex(reference)
end

local function visual_line_range()
  local start_line = vim.fn.line("v")
  local end_line = vim.fn.line(".")
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  return start_line, end_line
end

local function visual_reference()
  local path = buffer_path()
  if not path then
    return nil
  end

  local start_line, end_line = visual_line_range()
  if start_line == end_line then
    return string.format("%s:L%d", path, start_line)
  end

  return string.format("%s:L%d-L%d", path, start_line, end_line)
end

local function visual_lines()
  local start_line, end_line = visual_line_range()
  local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
  return table.concat(lines, "\n") .. "\n"
end

vim.keymap.set("n", "<leader>a", function()
  send_to_pi(buffer_path())
end, { desc = "Send file path to pi" })

vim.keymap.set("x", "<leader>a", function()
  send_to_pi(visual_reference())
end, { desc = "Send line reference to pi" })

vim.keymap.set("x", "<leader>A", function()
  send_to_pi(visual_lines(), false)
end, { desc = "Send selected lines to pi" })

return {}
