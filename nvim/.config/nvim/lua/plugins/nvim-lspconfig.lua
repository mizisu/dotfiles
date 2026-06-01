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
        keys = {
          { "<leader>ss", false },
          {
            "<leader>ss",
            function()
              require("utils.ty_workspace_symbols").open()
            end,
            desc = "Ty Workspace Symbols",
            enabled = function(buf)
              return vim.bo[buf].filetype == "python"
            end,
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
      ty = {
        enabled = true,
        settings = {
          ty = {
            -- Keep ty attached only for auto-import completion items.
            diagnosticMode = "off",
            showSyntaxErrors = false,
            completions = {
              autoImport = true,
            },
            inlayHints = {
              callArgumentNames = false,
              variableTypes = false,
            },
          },
        },
        on_attach = function(client)
          -- Leave completion enabled; basedpyright remains the Python LSP for
          -- hover, navigation, rename, references, inlay hints, etc.
          client.server_capabilities.codeActionProvider = false
          client.server_capabilities.declarationProvider = false
          client.server_capabilities.definitionProvider = false
          client.server_capabilities.diagnosticProvider = false
          client.server_capabilities.documentHighlightProvider = false
          client.server_capabilities.documentSymbolProvider = false
          client.server_capabilities.foldingRangeProvider = false
          client.server_capabilities.hoverProvider = false
          client.server_capabilities.implementationProvider = false
          client.server_capabilities.inlayHintProvider = false
          client.server_capabilities.referencesProvider = false
          client.server_capabilities.renameProvider = false
          client.server_capabilities.selectionRangeProvider = false
          client.server_capabilities.semanticTokensProvider = false
          client.server_capabilities.signatureHelpProvider = false
          client.server_capabilities.typeDefinitionProvider = false
          client.server_capabilities.workspaceSymbolProvider = false
        end,
      },
      basedpyright = {
        settings = {
          basedpyright = {
            -- Using Ruff's import organizer
            disableOrganizeImports = true,
            analysis = {
              -- ty provides auto-import completion items.
              autoImportCompletions = false,
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
