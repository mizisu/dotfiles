local M = {}

function M.is_git_repo()
  return vim.fn.isdirectory(".git") == 1
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