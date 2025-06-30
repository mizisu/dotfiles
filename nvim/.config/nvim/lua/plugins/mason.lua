return {
  "williamboman/mason.nvim",
  opts = {
    ensure_installed = {
      -- Lua
      "lua-language-server",
      -- Python
      "pyrefly",
      "debugpy",
      "mypy",
      "ruff",
      "basedpyright",

      -- Rust
      "rust-analyzer",
    },
  },
}
