#/bin/bash

# For brew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install applications
brew install stow \
  neovim \
  k9s \
  zellij \
  tmux

# Install cask applications
brew cask install docker

# Install tmux plugins
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
