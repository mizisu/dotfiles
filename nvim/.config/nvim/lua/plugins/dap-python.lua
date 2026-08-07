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

local DEFAULT_DJANGO_PORT = "7777"

local function get_django_api_port()
  local env_path = vim.fs.joinpath(vim.fn.getcwd(), ".env")
  local env_file = io.open(env_path, "r")
  if not env_file then
    return DEFAULT_DJANGO_PORT
  end

  local api_port

  for line in env_file:lines() do
    local key, port = line:match([[^%s*([%u_]+)%s*=%s*["']?(%d+)["']?%s*$]])
    if key == "WORKTRUNK_API_PORT" then
      env_file:close()
      return port
    elseif key == "API_PORT" then
      api_port = port
    end
  end

  env_file:close()
  return api_port or DEFAULT_DJANGO_PORT
end

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
      name = "Django (workspace)",
      program = "${workspaceFolder}/manage.py",
      cwd = "${workspaceFolder}",
      pythonPath = function()
        return vim.fs.joinpath(vim.fn.getcwd(), ".venv", "bin", "python")
      end,
      envFile = "${workspaceFolder}/.env",
      args = function()
        return {
          "runserver",
          "0.0.0.0:" .. get_django_api_port(),
          "--settings=server.settings.local",
          "--noreload",
          "--skip-checks",
        }
      end,
      django = true,
      justMyCode = true,
      console = "integratedTerminal",
    })
  end,
}
