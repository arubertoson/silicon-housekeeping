set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

src_extensions := "src/extensions"
agent_dir := "agent"
agent_extensions := agent_dir / "extensions"
pi_agent_dir := env_var_or_default("PI_AGENT_DIR", env_var("HOME") / ".pi/agent")

# Show available recipes.
default:
    @just --list

# List source extensions that can be linked into agent/extensions.
list:
    @find "{{ src_extensions }}" -mindepth 1 -maxdepth 1 | sort | while read -r src; do \
        name="${src#{{ src_extensions }}/}"; \
        if [[ -f "$src" && "$src" == *.ts && "$src" != *.test.ts ]]; then \
            echo "$name"; \
        elif [[ -d "$src" && -f "$src/index.ts" ]]; then \
            echo "$name/"; \
        fi; \
    done

# Symlink this repo's agent directory into the Pi config directory.
link-agent:
    @target="{{ pi_agent_dir }}"; \
    src="$(pwd)/{{ agent_dir }}"; \
    if [[ -e "$target" && ! -L "$target" ]]; then \
        echo "skip $target (exists and is not a symlink)"; \
        exit 1; \
    fi; \
    mkdir -p "$(dirname "$target")"; \
    [[ ! -L "$target" ]] || rm "$target"; \
    ln -s "$src" "$target"; \
    echo "linked $target -> $src"

# Remove the Pi config symlink if it points at this repo's agent directory.
unlink-agent:
    @target="{{ pi_agent_dir }}"; \
    src="$(pwd)/{{ agent_dir }}"; \
    if [[ -L "$target" && "$(realpath -m "$target")" == "$src" ]]; then \
        rm "$target"; \
        echo "removed $target"; \
    else \
        echo "skip $target (not a symlink to $src)"; \
    fi

# Symlink source extensions into agent/extensions. Existing non-symlinks are left untouched.
link:
    @mkdir -p "{{ agent_extensions }}"
    @find "{{ src_extensions }}" -mindepth 1 -maxdepth 1 | sort | while read -r src; do \
        name="${src#{{ src_extensions }}/}"; \
        if [[ -f "$src" ]]; then \
            [[ "$src" == *.ts && "$src" != *.test.ts ]] || continue; \
        elif [[ -d "$src" ]]; then \
            [[ -f "$src/index.ts" ]] || continue; \
        else \
            continue; \
        fi; \
        dst="{{ agent_extensions }}/$name"; \
        target="../../$src"; \
        if [[ -e "$dst" && ! -L "$dst" ]]; then \
            echo "skip $dst (exists and is not a symlink)"; \
            continue; \
        fi; \
        [[ ! -L "$dst" ]] || rm "$dst"; \
        ln -s "$target" "$dst"; \
        echo "linked $dst -> $target"; \
    done

# Remove symlinks in agent/extensions that point at src/extensions.
unlink:
    @project="$(pwd)"; \
    mkdir -p "{{ agent_extensions }}"; \
    find "{{ agent_extensions }}" -mindepth 1 -maxdepth 1 -type l | sort | while read -r dst; do \
        resolved="$(realpath -m "$dst")"; \
        if [[ "$resolved" == "$project/{{ src_extensions }}"/* ]]; then \
            rm "$dst"; \
            echo "removed $dst"; \
        fi; \
    done

# Recreate managed symlinks from src/extensions into agent/extensions.
refresh: unlink link

# Show current agent/extensions entries and their symlink targets.
status:
    @mkdir -p "{{ agent_extensions }}"
    @find "{{ agent_extensions }}" -mindepth 1 -maxdepth 1 | sort | while read -r path; do \
        if [[ -L "$path" ]]; then \
            echo "$path -> $(readlink "$path")"; \
        else \
            echo "$path"; \
        fi; \
    done
