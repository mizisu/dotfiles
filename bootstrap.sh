#/bin/bash

# For brew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install applications
brew install stow
brew install k9s
brew install zellij

# Install cask applications
brew cask install docker
