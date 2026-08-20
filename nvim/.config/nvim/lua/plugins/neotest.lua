---@diagnostic disable: missing-fields
return {
  {
    "nvim-neotest/neotest",
    dependencies = {
      "nvim-neotest/nvim-nio",
      "nvim-lua/plenary.nvim",
      "nvim-treesitter/nvim-treesitter",
      "antoinemadec/FixCursorHold.nvim",
      "nvim-neotest/neotest-python",
      "nvim-neotest/neotest-plenary",
    },
    keys = {
      {
        "<leader>tr",
        function()
          require("neotest").run.run()
        end,
        desc = "Run the nearest test",
      },
      {
        "<leader>td",
        function()
          require("neotest").run.run({
            strategy = "dap",
          })
        end,
        desc = "Debug the nearest test",
      },
      {
        "<leader>tf",
        function()
          require("neotest").run.run(vim.fn.expand("%"))
        end,
        desc = "Run the current file",
      },
      {
        "<leader>tA",
        function()
          require("neotest").run.run({
            suite = true,
          })
        end,
        desc = "Run all tests",
      },
      {
        "<leader>ta",
        function()
          require("neotest").run.attach()
        end,
        desc = "Attach to the nearest test",
      },
      {
        "<leader>tu",
        function()
          require("neotest").run.stop()
        end,
        desc = "Stop the test",
      },
      {
        "<leader>to",
        function()
          require("neotest").output.open({ enter = true })
        end,
        desc = "Show test ouput",
      },
      {
        "<leader>tp",
        function()
          require("neotest").output_panel.toggle()
        end,
        desc = "Toggle test output panel",
      },

      {
        "<leader>ts",
        function()
          require("neotest").summary.toggle()
        end,
        desc = "Show test summary",
      },
    },
    config = function()
      require("neotest").setup({
        adapters = {
          require("neotest-python")({
            dap = {
              justMyCode = false,
            },
          }),
          require("neotest-plenary"),
        },
        output = {
          open_on_run = true,
          enter = true,
          -- open_win = function()
          --     vim.cmd("vsplit")
          --     vim.opt_local.wrap = false
          --     return vim.api.nvim_get_current_win()
          -- end,
        },
        floating = {
          max_height = 0.8,
          max_width = 0.8,
        },
        output_panel = {
          open = "botright split | resize 20 | setlocal nowrap",
        },
      })
    end,
  },
}
