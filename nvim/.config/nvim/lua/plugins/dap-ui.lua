return {
  "rcarriga/nvim-dap-ui",
  lazy = true,
  dependencies = { "mfussenegger/nvim-dap", "nvim-neotest/nvim-nio" },
  opts = {
    layouts = { --  1 watches, scopes, console
      {
        elements = { --
          {
            id = "watches",
            size = 0.25,
          }, --
          {
            id = "scopes",
            size = 0.25,
          }, --
          {
            id = "console",
            size = 0.5,
          }, --
        },
        position = "bottom",
        size = 20,
      }, -- 2 breakpoints
      {
        elements = { {
          id = "breakpoints",
          size = 1,
        } },
        position = "left",
        size = 40,
      }, -- 3 repl
      {
        elements = { {
          id = "repl",
          size = 1,
        } },
        position = "bottom",
        size = 20,
      }, -- 4 stacks
      {
        elements = { {
          id = "stacks",
          size = 1,
        } },
        position = "left",
        size = 40,
      },
    },
  },
  keys = {
    {
      "<leader>du",
      function()
        require("dapui").toggle({
          layout = 1,
        })
      end,
      desc = "Open dap ui",
    },
    {
      "<leader>dw",
      desc = "Wdigets",
    }, --
    { "<leader>dr", function() end }, --
    {
      "<leader>dwb",
      function()
        require("dapui").toggle({
          layout = 2,
        })
      end,
      desc = "Wdiget Toggle breakpoints",
    },
    {
      "<leader>dwr",
      function()
        require("dapui").toggle({
          layout = 3,
        })
      end,
      desc = "Wdiget Toggle repl",
    },
    {
      "<leader>dws",
      function()
        require("dapui").toggle({
          layout = 4,
        })
      end,
      desc = "Wdiget Toggle stacks",
    },
  },
  config = function(_, opts)
    local dap = require("dap")
    local dapui = require("dapui")
    dapui.setup(opts)
    dap.listeners.after.event_initialized["dapui_config"] = function()
      dapui.open({
        layout = 1,
      })
    end
    dap.listeners.before.event_terminated["dapui_config"] = function()
      dapui.close({})
    end
    dap.listeners.before.event_exited["dapui_config"] = function()
      dapui.close({})
    end
  end,
}
