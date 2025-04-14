return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      pyright = {
        settings = {
          python = {
            -- Using Ruff's import organizer
            disableOrganizeImports = true,
            analysis = {
              autoSearchPaths = true,
              useLibraryCodeForTypes = true,
              -- diagnosticMode = "workspace",
              ignore = { "*", ".venv" },
            },
            exclude = { ".venv" },
            venvPath = "./",
            venv = ".venv",
            -- import 관련 추가 설정
            importFormat = "absolute",
            autoImportCompletions = true,
          },
        },
      },
    },
  },
}
