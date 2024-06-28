-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Telescope
vim.keymap.set("n", "<leader>fk", ":Telescope keymaps<CR>")
vim.keymap.set("n", "<leader>fw", LazyVim.pick("live_grep"), { desc = "Grep" })

-- Delete not override clipboard
vim.keymap.set("n", "d", '"_d')
vim.keymap.set("v", "d", '"_d')

-- Close buffer
vim.keymap.set("n", "<ledaer>x", "<leader>bd")

-- Go back and forward
vim.keymap.set("n", "<C-[>", "<C-o>")
vim.keymap.set("n", "<C-]>", "<C-i>")
