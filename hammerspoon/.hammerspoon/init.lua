local input_source = require("modules.input_source")
local mission_control = require("modules.mission-control")
local app_shortcut = require("modules.app-shortcut")
local exosphere = require("modules.exosphere")

input_source.setup()
mission_control.setup()
app_shortcut.setup()
exosphere.setup_exosphere_automation()
