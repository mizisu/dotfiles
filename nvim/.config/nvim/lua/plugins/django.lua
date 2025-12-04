return {
  "django.nvim",
  dependencies = {
    { "folke/snacks.nvim" },
    {
      "saghen/blink.cmp",
      opts = {
        sources = {
          default = { "django" },
          providers = {
            django = {
              name = "django",
              module = "django.completions.blink",
              async = true,
            },
          },
        },
      },
    },
  },
  dir = "/Users/charles/Desktop/src/django.nvim",
  config = function()
    require("django").setup()
  end,
}
