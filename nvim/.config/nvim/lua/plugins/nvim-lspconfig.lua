return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      ["*"] = {
        capabilities = {
          general = {
            positionEncodings = { "utf-16" },
          },
        },
      },
      -- Explicitly disable null-ls as it's handled by none-ls
      ["null-ls"] = false,
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
      --
      -- for pyrefly?
      -- basedpyright = {
      --   settings = {
      --     basedpyright = {
      --       -- Using Ruff's import organizer
      --       disableOrganizeImports = true,
      --       disableLanguageServices = true,
      --       analysis = {
      --         typeCheckingMode = "off",
      --         autoImportCompletions = false,
      --         autoSearchPaths = false,
      --         useLibraryCodeForTypes = false,
      --         -- diagnosticMode = "workspace",
      --         diagnosticMode = "openFilesOnly",
      --         inlayHints = {
      --           callArgumentNames = false,
      --         },
      --       },
      --       venvPath = "./",
      --       venv = ".venv",
      --       -- import 관련 추가 설정
      --       importFormat = "absolute",
      --     },
      --   },
      -- },
      -- ty = {},
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
      -- configs end
    },
  },
}
