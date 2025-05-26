local uv = vim.loop
local git_head = nil

local function get_git_branch()
  local head_file = vim.fn.finddir('.git', '.;') .. '/HEAD'
  local f = io.open(head_file, "r")
  if not f then return nil end
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

local function print_branch_change_message(branch, base_ref)
  if base_ref then
    print("현재 브랜치: " .. branch .. " -> " .. base_ref)
  else
    print("현재 브랜치: " .. branch)
  end
end

local function change_gitsigns_base(base_ref)
  if base_ref then
    -- vim.cmd("Gitsigns change_base " .. base_ref)
    vim.cmd("Gitsigns change_base " .. base_ref)
  end
end

local function check_branch_change()
  local branch = get_git_branch()
  if not branch or branch == git_head then
    return
  end

  git_head = branch
  local base_ref = get_base_ref()
  print_branch_change_message(branch, base_ref)
  change_gitsigns_base(base_ref)
end

uv.new_timer():start(0, 5000, vim.schedule_wrap(check_branch_change))

local base_ref = get_base_ref()
change_gitsigns_base(base_ref)
