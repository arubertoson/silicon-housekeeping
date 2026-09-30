set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

pi_agent_dir := env_var_or_default("PI_AGENT_DIR", env_var("HOME") / ".pi/agent")

# Show available recipes.
default:
    @just --list

# Symlink this repository directly into Pi's agent directory.
link-agent:
    @target="{{ pi_agent_dir }}"; \
    src="$(pwd)"; \
    if [[ -e "$target" || -L "$target" ]]; then \
        if [[ -L "$target" && "$(realpath -m "$target")" == "$src" ]]; then \
            echo "$target already links to $src"; \
            exit 0; \
        fi; \
        echo "skip $target (already exists; remove it explicitly before linking)"; \
        exit 1; \
    fi; \
    mkdir -p "$(dirname "$target")"; \
    ln -s "$src" "$target"; \
    echo "linked $target -> $src"

# Remove the Pi config symlink if it points at this repository.
unlink-agent:
    @target="{{ pi_agent_dir }}"; \
    src="$(pwd)"; \
    if [[ -L "$target" && "$(realpath -m "$target")" == "$src" ]]; then \
        rm "$target"; \
        echo "removed $target"; \
    else \
        echo "skip $target (not a symlink to $src)"; \
    fi
