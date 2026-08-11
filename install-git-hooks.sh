#!/bin/bash
# git 훅을 건다. .git/hooks는 커밋되지 않아 클론마다 한 번 돌려야 한다.
# 이미 걸린 우리 링크는 묻지 않고 최신으로 다시 건다.
# sh가 아니라 bash인 것은 프롬프트에서 엔터 없이 한 글자를 받으려고(read -n 1) 한다.
set -e

root=$(git rev-parse --show-toplevel)
cd "$root"

hook=.git/hooks/pre-merge-commit
target=../../test-all.sh

# 우리가 건 링크가 아닌 무언가가 있으면 백업하고 건다. 물어서 아니라면 그대로 둔다.
if [ -e "$hook" ] && [ "$(readlink "$hook")" != "$target" ]; then
	backup="$hook.bak.$(date +%Y%m%d%H%M%S)"

	if [ ! -t 0 ]; then
		echo "$hook 에 다른 훅이 있다. 터미널에서 직접 실행해 백업 여부를 답한다." >&2
		exit 0
	fi

	printf "%s 에 다른 훅이 있다. %s 로 옮기고 걸까? [y/N] " "$hook" "$backup"
	read -r -n 1 answer
	echo "$answer"
	case "$answer" in
		y | Y) ;;
		*)
			echo "그대로 뒀다. 훅을 걸지 않았다."
			exit 0
			;;
	esac

	mv "$hook" "$backup"
	echo "기존 훅을 $backup 로 옮겼다."
fi

ln -sf "$target" "$hook"
echo "pre-merge-commit -> test-all.sh"
