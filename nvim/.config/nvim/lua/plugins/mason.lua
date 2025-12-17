return {
  "mason-org/mason.nvim",
  opts = {
    ensure_installed = {
      -- Lua
      "lua-language-server",
      -- Python
      -- "pyrefly",
      -- "ty",
      "debugpy",
      "mypy",
      "ruff",
      "basedpyright",

      -- Rust
      "rust-analyzer",

      -- Javascript/TypeScript
      "biome",
    },
  },
}
