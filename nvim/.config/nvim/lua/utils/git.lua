local M = {}

function M.is_git_repo()
  local output = vim.fn.system({ "git", "rev-parse", "--is-inside-work-tree" })
  return vim.v.shell_error == 0 and vim.trim(output) == "true"
end

function M.get_base_ref()
  local output = vim.fn.system("gh pr view --json baseRefName -q .baseRefName")
  output = vim.trim(output)
  if output ~= "" and vim.v.shell_error == 0 then
    return output
  end
  return nil
end

return M