-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Delete not override clipboard
vim.keymap.set("n", "d", '"_d')
vim.keymap.set("v", "d", '"_d')

-- vim.keymap.set("n", "<C-d>", "<C-d>zz", { desc = "Scroll down" })
-- vim.keymap.set("n", "<C-u>", "<C-u>zz", { desc = "Scroll up" })
vim.keymap.set("n", "<C-b>", "<cmd>:bd<CR>", { desc = "Close buffer" })

-- Keep tmux navigation when nested; Rex gets focus only at a Neovim edge.
for key, direction in pairs({ h = "left", j = "down", k = "up", l = "right" }) do
  if require("config.rex").active() then
    vim.keymap.set("n", "<C-" .. key .. ">", function()
      require("config.rex").navigate(direction, key)
    end, { desc = "Window " .. direction .. " (Neovim/Rex)" })
  else
    local command = "TmuxNavigate" .. direction:sub(1, 1):upper() .. direction:sub(2)
    vim.keymap.set("n", "<C-" .. key .. ">", "<cmd>" .. command .. "<CR>", { desc = "Window " .. direction })
  end
end

vim.keymap.set("n", "q", "")
