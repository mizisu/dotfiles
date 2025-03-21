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
                            ignore = {'*'}
                        }
                    }
                }
            }
        }

    }
}
