# Keep `zsh -i -c ...` quiet; real interactive terminals still use p10k gitstatus.
if [[ -n ${ZSH_EXECUTION_STRING:-} ]]; then
  typeset -g POWERLEVEL9K_DISABLE_GITSTATUS=true
fi

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time Oh My Zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="robbyrussell"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
	git
	zsh-syntax-highlighting
	zsh-autosuggestions
	zsh-completions
)

source $ZSH/oh-my-zsh.sh

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='nvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch $(uname -m)"

# Set personal aliases, overriding those provided by Oh My Zsh libs,
# plugins, and themes. Aliases can be placed here, though Oh My Zsh
# users are encouraged to define aliases within a top-level file in
# the $ZSH_CUSTOM folder, with .zsh extension. Examples:
# - $ZSH_CUSTOM/aliases.zsh
# - $ZSH_CUSTOM/macos.zsh
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"

# z.sh
# source ~/z.sh
eval "$(zoxide init zsh)"

# fzf
if [[ -z ${ZSH_EXECUTION_STRING:-} ]]; then
  [[ -r /opt/homebrew/opt/fzf/shell/completion.zsh ]] && source /opt/homebrew/opt/fzf/shell/completion.zsh
  [[ -r /opt/homebrew/opt/fzf/shell/key-bindings.zsh ]] && source /opt/homebrew/opt/fzf/shell/key-bindings.zsh
fi

# Add path 
export PATH="/Users/charles/.local/bin:$PATH"

# Git
alias branch="git symbolic-ref --short HEAD"
alias gpo='git push -u origin $(branch)'
alias gpoc='git push -u origin $(branch) && gh pr create --web -a @me'
alias base-ref="gh pr view --json baseRefName -q .baseRefName"
alias gs="git branch -a | sed 's/remotes\/origin\///' | sort -u | fzf | xargs git switch"
alias gb="git branch -a | sed 's/remotes\/origin\///' | sort -u | fzf"
alias mypr="gh pr list -a @me | fzf | sed -n 's/^\([0-9]*\).*/\1/p' | xargs gh pr checkout"
alias review="gh pr list -S 'user-review-requested:@me' | fzf | sed -n 's/^\([0-9]*\).*/\1/p' | xargs gh pr checkout"

# CodeRabbit
alias cr-review='git fetch origin $(base-ref):$(base-ref) &&  cr review --base=$(base-ref) --prompt-only'

# VIM
alias vim='rm -f ~/.cache/nvim/server.pipe && nvim --listen ~/.cache/nvim/server.pipe'

# bat
alias cat=bat

# Python
alias venv="source .venv/bin/activate"

# mysql-client
export PATH="/opt/homebrew/opt/mysql-client/bin:$PATH"
export LDFLAGS="-L/opt/homebrew/opt/mysql-client/lib"
export CPPFLAGS="-I/opt/homebrew/opt/mysql-client/include"
export PKG_CONFIG_PATH="/opt/homebrew/opt/mysql-client/lib/pkgconfig"

# Mariadb
export PATH="/opt/homebrew/opt/mariadb-connector-c/bin:$PATH"
export LDFLAGS="-L/opt/homebrew/opt/mariadb-connector-c/lib"
export CPPFLAGS="-I/opt/homebrew/opt/mariadb-connector-c/include"
export PKG_CONFIG_PATH="/opt/homebrew/opt/mariadb-connector-c/lib/pkgconfig"

# Lazygit
alias lg="lazygit"

# opencode
export PATH=/Users/charles/.opencode/bin:$PATH
alias oc="opencode"
alias pwoc='\
  GITHUB_TOKEN=$(op item get dnuu5rsp67thk4sfhslwigo2uq --reveal --fields password) \
  QUERYPIE_PASSWORD=$(op item get mnjfg6b4stmu2pet52jttfk4sq --reveal --fields password) \
  opencode'

# eza
alias ls='eza'

export EDITOR=/opt/homebrew/bin/nvim

# Lemonbase
alias bastion="tsh ssh -A ubuntu@bastion-prod"
alias bastion-dev="ssh bastion-dev"
alias awsdev='./scripts/aws/get_aws_access_token.py --serial-number arn:aws:iam::455628414130:mfa/charles@lemonbase.com  --token=$(op item get 3xbm2z37nniqk5k2mojzcyhj2m --otp)'
alias dump-temp="./scripts/dumpdb.sh lemonbase_temp --recreate --test"

function uuid() { python3 -c "import uuid; arg_uuid='$1';" }

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :

# Go version manager
gvm() {
  unset -f gvm
  if [[ -s "$HOME/.gvm/scripts/gvm" ]]; then
    source "$HOME/.gvm/scripts/gvm"
    gvm "$@"
  else
    print -u2 "gvm: $HOME/.gvm/scripts/gvm not found"
    return 127
  fi
}

# Run Sublime Text in terminal
export PATH="/Applications/Sublime Text.app/Contents/SharedSupport/bin:$PATH"

if [[ -z ${ZSH_EXECUTION_STRING:-} ]]; then
  _wt_init_cache="${XDG_CACHE_HOME:-$HOME/.cache}/wt-shell-init.zsh"
  _wt_bin="${WORKTRUNK_BIN:-$(command -v wt 2>/dev/null)}"
  if [[ -n $_wt_bin ]]; then
    if [[ ! -r $_wt_init_cache || $_wt_init_cache -ot $_wt_bin ]]; then
      mkdir -p "${_wt_init_cache:h}"
      command "$_wt_bin" config shell init zsh >| "$_wt_init_cache" 2>/dev/null
    fi
    [[ -r $_wt_init_cache ]] && source "$_wt_init_cache"
  fi
  unset _wt_init_cache _wt_bin
fi

# Node Version Manager
export NVM_DIR="$HOME/.nvm"
# Keep the default Node version available without sourcing nvm on every shell startup.
typeset -U path
if [[ -r "$NVM_DIR/alias/default" ]]; then
  _nvm_default_version="$(<"$NVM_DIR/alias/default")"
  [[ $_nvm_default_version == v* ]] || _nvm_default_version="v$_nvm_default_version"
  _nvm_default_dirs=("$NVM_DIR/versions/node"/${_nvm_default_version}*(/N))
  if (( ${#_nvm_default_dirs} )); then
    path=("${_nvm_default_dirs[-1]}/bin" "${path[@]}")
    export NVM_BIN="${_nvm_default_dirs[-1]}/bin"
  fi
  unset _nvm_default_version _nvm_default_dirs
fi
nvm() {
  unset -f nvm
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh" --no-use
  [[ -s "$NVM_DIR/bash_completion" ]] && source "$NVM_DIR/bash_completion"
  nvm "$@"
}

# Powerlevel10k theme
if [[ -z ${ZSH_EXECUTION_STRING:-} ]]; then
  source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
  # To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
  [[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
fi
