local uv = vim.loop
local git_head = nil
local base_ref = nil

local function is_git_repo()
  return vim.fn.isdirectory(".git") == 1
end

local function get_git_branch()
  local head_file = vim.fn.finddir(".git", ".;") .. "/HEAD"
  local f = io.open(head_file, "r")
  if not f then
    return nil
  end
  local head = f:read("*l")
  f:close()
  if head:match("^ref: refs/heads/") then
    return head:gsub("^ref: refs/heads/", "")
  else
    return head
  end
end

local function get_base_ref()
  local output = vim.fn.system("gh pr view --json baseRefName -q .baseRefName")
  output = vim.trim(output)
  if output ~= "" and vim.v.shell_error == 0 then
    return output
  end
  return nil
end

local function print_branch_change_message(branch)
  if base_ref then
    print("현재 브랜치: " .. branch .. " -> " .. base_ref)
  else
    print("현재 브랜치: " .. branch)
  end
end

local function change_gitsigns_base()
  if not is_git_repo() then
    return
  end
  require("gitsigns")
  if base_ref then
    vim.cmd("Gitsigns change_base " .. base_ref)
  end
end

local function check_branch_change()
  if not is_git_repo() then
    return
  end
  local branch = get_git_branch()
  if not git_head then
    git_head = branch
    base_ref = get_base_ref()
    print_branch_change_message(branch)
    return
  end

  if branch == git_head then
    return
  end

  base_ref = get_base_ref()
  print_branch_change_message(branch)
end

if is_git_repo() then
  uv.new_timer():start(1000, 3000, vim.schedule_wrap(check_branch_change))
  uv.new_timer():start(0, 1000, vim.schedule_wrap(change_gitsigns_base))
end

return {}

