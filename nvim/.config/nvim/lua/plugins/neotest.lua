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
          require("neotest").run.run({ strategy = "dap" })
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
          require("neotest").run.run({ suite = true })
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
      -- Django 환경 변수 미리 설정
      vim.env.DJANGO_SETTINGS_MODULE = "server.settings.test"

      require("neotest").setup({
        adapters = {
          require("neotest-python")({
            dap = { justMyCode = false },
            runner = "django",
            args = {
              "--keepdb", -- 테스트 데이터베이스 재사용
            },
          }),
          require("neotest-plenary"),
        },
        output = {
          open_on_run = true,
        },
      })
    end,
  },
}
