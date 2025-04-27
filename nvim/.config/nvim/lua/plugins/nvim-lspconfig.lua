return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      -- pyright = {
      --   settings = {
      --     python = {
      --       -- Using Ruff's import organizer
      --       disableOrganizeImports = true,
      --       analysis = {
      --         autoImportCompletions = true,
      --         autoSearchPaths = true,
      --         useLibraryCodeForTypes = true,
      --         -- diagnosticMode = "workspace",
      --         ignore = { "*", ".venv" },
      --       },
      --       exclude = { ".venv" },
      --       venvPath = "./",
      --       venv = ".venv",
      --       -- import 관련 추가 설정
      --       importFormat = "absolute",
      --     },
      --   },
      -- },
      basedpyright = {
        settings = {
          basedpyright = {
            -- Using Ruff's import organizer
            disableOrganizeImports = true,
            analysis = {
              autoImportCompletions = true,
              autoSearchPaths = true,
              useLibraryCodeForTypes = true,
              -- diagnosticMode = "workspace",
              diagnosticMode = "openFilesOnly",
              inlayHints = {
                callArgumentNames = false,
              },
            },
            venvPath = "./",
            venv = ".venv",
            -- import 관련 추가 설정
            importFormat = "absolute",
          },
        },
      },
    },
  },
}
