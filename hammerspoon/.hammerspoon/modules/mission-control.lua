local M = {}

function M.setup()
	hs.hotkey.bind({ "ctrl", "shift", "cmd" }, "r", function()
		local centerScreenUUID = "C0DDF67C-D067-4409-ADBD-9B63862CA249"

		for k, v in pairs(hs.spaces.allSpaces()) do
			for i = 1, #v do
				hs.spaces.removeSpace(v[i])
			end
		end

		local allScreens = hs.screen.allScreens()
		if #allScreens == 2 then
			local screen1 = allScreens[1]:getUUID()
			local screen2 = allScreens[2]:getUUID()

			hs.spaces.addSpaceToScreen(screen1)
			hs.spaces.addSpaceToScreen(screen2)
			hs.spaces.addSpaceToScreen(screen2)
		elseif #allScreens == 3 then
			local screen1 = allScreens[1]:getUUID()
			local screen2 = allScreens[2]:getUUID()
			local screen3 = allScreens[3]:getUUID()

			hs.spaces.addSpaceToScreen(screen1)
			hs.spaces.addSpaceToScreen(screen2)
			hs.spaces.addSpaceToScreen(screen2)
		end
	end)
end

return M
