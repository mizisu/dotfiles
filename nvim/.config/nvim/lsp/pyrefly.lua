return {
  cmd = { "pyrefly", "lsp" },
  filetypes = { "python" },
  settings = {},
  root_markers = { "pyrefly.toml" },
  on_exit = function(code, _, _)
    vim.notify("Closing Pyrefly LSP exited with code: " .. code, vim.log.levels.INFO)
  end,
}

