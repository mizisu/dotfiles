local state = { buf = nil, win = nil }

local function open_float()
  local width = vim.o.columns
  local height = vim.o.lines - vim.o.cmdheight
  state.win = vim.api.nvim_open_win(state.buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = 0,
    col = 0,
    style = "minimal",
  })
end

local function toggle()
  -- 열려있으면 숨기기 (프로세스 유지)
  if state.win and vim.api.nvim_win_is_valid(state.win) then
    vim.api.nvim_win_close(state.win, true)
    state.win = nil
    return
  end
  -- 버퍼 살아있으면 윈도우만 다시 열기
  if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
    open_float()
    vim.cmd("startinsert")
    return
  end
  -- 최초 실행
  state.buf = vim.api.nvim_create_buf(false, true)
  vim.bo[state.buf].bufhidden = "hide"
  open_float()
  vim.fn.jobstart({ "gh", "dash" }, {
    term = true,
    on_exit = function()
      vim.schedule(function()
        if state.win and vim.api.nvim_win_is_valid(state.win) then
          vim.api.nvim_win_close(state.win, true)
          state.win = nil
        end
        if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
          vim.api.nvim_buf_delete(state.buf, { force = true })
          state.buf = nil
        end
      end)
    end,
  })
  vim.keymap.set("t", "<Esc>", toggle, { buffer = state.buf, silent = true })
  vim.cmd("startinsert")
end

vim.keymap.set("n", "<leader>ghp", toggle, { desc = "Toggle gh-dash" })

vim.api.nvim_create_autocmd("VimResized", {
  callback = function()
    if state.win and vim.api.nvim_win_is_valid(state.win) then
      local width = vim.o.columns
      local height = vim.o.lines - vim.o.cmdheight
      vim.api.nvim_win_set_config(state.win, {
        relative = "editor",
        width = width,
        height = height,
        row = 0,
        col = 0,
      })
    end
  end,
})

return {
  -- gitsigns의 <leader>ghp (Preview Hunk Inline) buffer-local 충돌 제거
  {
    "lewis6991/gitsigns.nvim",
    opts = function(_, opts)
      local prev_attach = opts.on_attach
      opts.on_attach = function(buf)
        if prev_attach then
          prev_attach(buf)
        end
        pcall(vim.keymap.del, "n", "<leader>ghp", { buffer = buf })
      end
    end,
  },
}
