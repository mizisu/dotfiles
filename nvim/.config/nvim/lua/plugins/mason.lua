return {
  "williamboman/mason.nvim",
  opts = {
    ensure_installed = {
      -- Lua
      "lua-language-server",
      -- Python
      "debugpy",
      "mypy",
      "ruff",
      "ruff-lsp",
      "pyright",

      -- Rust
      "rust-analyzer",
    },
  },
}
