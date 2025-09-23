local git_utils = require("utils.git")

local function open_diffview_with_base()
  if not git_utils.is_git_repo() then
    vim.cmd("DiffviewOpen")
    return
  end

  local base_ref = git_utils.get_base_ref()
  if base_ref then
    vim.cmd("DiffviewOpen origin/" .. base_ref .. "...HEAD")
  else
    vim.cmd("DiffviewOpen")
  end
end

return {
  "sindrets/diffview.nvim",
  keys = {
    { "<leader>gD", open_diffview_with_base, desc = "Diffview Open with base" },
    { "<leader>gd", "<cmd>DiffviewOpen<cr>", desc = "Diffview Open" },
    { "<leader>gc", "<cmd>DiffviewClose<cr>", desc = "Diffview Close" },
    { "<leader>gF", "<cmd>DiffviewFileHistory<cr>", desc = "Diffview File History" },
  },
}
