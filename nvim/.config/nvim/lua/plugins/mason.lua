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
      "basedpyright",

      -- Rust
      "rust-analyzer",
    },
  },
}
