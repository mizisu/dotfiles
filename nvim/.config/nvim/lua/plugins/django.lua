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
  shell = {
    command = "shell", -- "shell", "shell_plus", "shell_plus --ipython", etc.
    split = {
      position = "right", -- "bottom", "top", "left", "right", "float"
      size = 0.3, -- lines for horizontal, columns for vertical, or {width, height} for float
    },
    env = {}, -- explicit environment variables override
    env_file = ".env", -- file to load DJANGO_SETTINGS_MODULE from, false to disable
  },

  dir = "/Users/charles/Desktop/src/django.nvim",
  config = function()
    require("django").setup()
  end,
}
