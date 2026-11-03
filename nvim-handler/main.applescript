on open location this_URL
	try
		set app_path to path to me as text
		set resources_path to app_path & "Contents:Resources:"
		set script_path to POSIX path of (resources_path & "nvim-url-handler.sh")
		
		-- Both values use AppleScript's shell quoting. The handler itself launches
		-- Rex and Neovim with argv arrays and never evaluates URL text as code.
		set shell_command to quoted form of script_path & " " & quoted form of this_URL
		do shell script shell_command
	on error error_message
		display dialog "Failed to open Neovim: " & error_message buttons {"OK"} default button "OK"
	end try
end open location

on run
	display dialog "NvimHandler is ready for nvim://file/ URLs." buttons {"OK"} default button "OK"
end run
