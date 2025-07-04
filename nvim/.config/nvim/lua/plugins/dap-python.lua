-- { "<leader>dB", function() require("dap").set_breakpoint(vim.fn.input('Breakpoint condition: ')) end, desc = "Breakpoint Condition" },
-- { "<leader>db", function() require("dap").toggle_breakpoint() end, desc = "Toggle Breakpoint" },
-- { "<leader>dc", function() require("dap").continue() end, desc = "Run/Continue" },
-- { "<leader>da", function() require("dap").continue({ before = get_args }) end, desc = "Run with Args" },
-- { "<leader>dC", function() require("dap").run_to_cursor() end, desc = "Run to Cursor" },
-- { "<leader>dg", function() require("dap").goto_() end, desc = "Go to Line (No Execute)" },
-- { "<leader>di", function() require("dap").step_into() end, desc = "Step Into" },
-- { "<leader>dj", function() require("dap").down() end, desc = "Down" },
-- { "<leader>dk", function() require("dap").up() end, desc = "Up" },
-- { "<leader>dl", function() require("dap").run_last() end, desc = "Run Last" },
-- { "<leader>do", function() require("dap").step_out() end, desc = "Step Out" },
-- { "<leader>dO", function() require("dap").step_over() end, desc = "Step Over" },
-- { "<leader>dP", function() require("dap").pause() end, desc = "Pause" },
-- { "<leader>dr", function() require("dap").repl.toggle() end, desc = "Toggle REPL" },
-- { "<leader>ds", function() require("dap").session() end, desc = "Session" },
-- { "<leader>dt", function() require("dap").terminate() end, desc = "Terminate" },
-- { "<leader>dw", function() require("dap.ui.widgets").hover() end, desc = "Widgets" },

return {
  "mfussenegger/nvim-dap-python",
    -- stylua: ignore
    keys = {{
        "<leader>dPt",
        function()
            require('dap-python').test_method()
        end,
        desc = "Debug Method",
        ft = "python"
    }, {
        "<leader>dPc",
        function()
            require('dap-python').test_class()
        end,
        desc = "Debug Class",
        ft = "python"
    },
    { "<leader>dn", function() require("dap").step_over() end, desc = "Step Over" },
  },

  config = function()
    require("dap-python").setup("uv")
    table.insert(require("dap").configurations.python, 1, {
      type = "python",
      request = "launch",
      name = "django",
      program = "${workspaceFolder}/manage.py",
      args = {
        "runserver",
        "7777",
        "--settings=server.settings.local",
        "--noreload",
        "--skip-checks",
      },
      console = "integratedTerminal",
      -- ... more options, see https://github.com/microsoft/debugpy/wiki/Debug-configuration-settings
    })
  end,
}
