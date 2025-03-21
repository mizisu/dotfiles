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
      "pyright",

      -- Rust
      "rust-analyzer",
    },
  },
}
