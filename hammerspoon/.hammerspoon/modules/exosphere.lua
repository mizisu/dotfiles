local M = {}

local function wait_for_exosphere_with_while()
	local maxWaitTime = 5.0
	local checkInterval = 0.1
	local startTime = hs.timer.secondsSinceEpoch()

	while true do
		local exosphere = hs.application.find("Exosphere")
		if exosphere and exosphere:isFrontmost() then
			return true
		end

		if hs.timer.secondsSinceEpoch() - startTime > maxWaitTime then
			hs.alert.show("Exosphere 프로그램을 찾을 수 없습니다")
			return false
		end

		hs.timer.usleep(checkInterval * 1000000)
	end
end

function M.setup_exosphere_automation()
	hs.hotkey.bind({ "cmd", "shift" }, "e", function()
		local finder = hs.application.find("Finder")
		if not finder or not finder:isFrontmost() then
			hs.alert.show("Finder가 활성화되어 있지 않습니다")
			return
		end

		local initialMousePosition = hs.mouse.absolutePosition()

		local actions = {
			{
				fn = function()
					hs.eventtap.rightClick(hs.mouse.absolutePosition())
				end,
				delay = 0.1,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "e")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "right")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "t")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "return")
				end,
				delay = 0.5,
			},

			{
				fn = function()
					wait_for_exosphere_with_while()
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({ "shift", "cmd" }, "space")
				end,
				delay = 0.2,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "t")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "return")
				end,
				delay = 0.3,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({ "shift", "cmd" }, "space")
				end,
				delay = 0.2,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "i")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "return")
				end,
				delay = 0.3,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({ "shift", "cmd" }, "space")
				end,
				delay = 0.2,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "o")
				end,
				delay = 0,
			},
			{
				fn = function()
					hs.eventtap.keyStroke({}, "return")
				end,
				delay = 1000,
			},
			{
				fn = function()
					hs.mouse.setAbsolutePosition(initialMousePosition)
				end,
				delay = 0,
			},
		}

		local function executeAction(index)
			if index > #actions then
				return
			end

			local action = actions[index]
			action.fn()

			if action.delay > 0 then
				hs.timer.doAfter(action.delay, function()
					executeAction(index + 1)
				end)
			else
				executeAction(index + 1)
			end
		end

		executeAction(1)
	end)
end

return M
