-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

vim.opt.relativenumber = true

-- Folding Option
vim.opt.foldlevel = 99
vim.opt.foldexpr = "v:lua.vim.treesitter.foldexpr()"
vim.opt.foldmethod = "expr"

-- vim.g.lazyvim_python_lsp = "pyright"
vim.g.lazyvim_python_lsp = "basedpyright"
-- vim.lsp.enable({ "pyrefly" })
-- vim.g.lazyvim_python_lsp = "pyrefly"

vim.g.lazyvim_python_ruff = "ruff"
