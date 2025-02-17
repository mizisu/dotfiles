-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Delete not override clipboard
vim.keymap.set("n", "d", '"_d')
vim.keymap.set("v", "d", '"_d')
