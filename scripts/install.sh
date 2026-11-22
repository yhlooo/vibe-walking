#!/bin/bash

set -eo pipefail

# 解析版本与安装后启动选项
version=""
run=false
for arg in "$@"; do
  case "${arg}" in
    --run)
      run=true
      ;;
    -*)
      echo "Error: unknown option ${arg}" >&2
      exit 1
      ;;
    *)
      if [[ -n "${version}" ]]; then
        echo "Usage: bash install.sh [version] [--run]" >&2
        exit 1
      fi
      version="${arg}"
      ;;
  esac
done
version="${version:-latest}"

# 确定操作系统
os="$(uname -s)"
case "${os}" in
  "Linux")
    os="linux"
  ;;
  "Darwin")
    os="darwin"
  ;;
  *)
    echo -e "\033[31mError: unsupported os ${os}\033[0m"
    exit 1
  ;;
esac

# 确定 CPU 架构
arch="$(uname -m)"
case "${arch}" in
  "x86_64")
    arch="amd64"
  ;;
  "arm64"|"aarch64")
  ;;
  *)
    echo -e "\033[31mError: unsupported arch ${arch}\033[0m"
    exit 1
  ;;
esac

# 确定安装位置
install_dir="${INSTALL_DIR:-${HOME}/.local/bin}"

# 确定 URL
if [[ "${version}" == "latest" ]]; then
  url="https://github.com/yhlooo/vibe-walking/releases/latest/download/vibe-walking-${os}-${arch}.tar.gz"
else
  url="https://github.com/yhlooo/vibe-walking/releases/download/${version}/vibe-walking-${os}-${arch}.tar.gz"
fi

echo -e "\033[34minstalling vibe-walking (${version}, ${os}/${arch}) to '${install_dir}/vibe-walking' ...\033[0m"
echo -e "\033[34mdownload from ${url}\033[0m"

# 下载、解压
mkdir -p "${install_dir}"
(
  temp_dir="$(mktemp -d "${install_dir}/.vibe-walking.XXXXXX")"
  trap 'rm -rf -- "${temp_dir}"' EXIT
  curl -fsSL "${url}" | tar -C "${temp_dir}" -xzv vibe-walking
  chmod +x "${temp_dir}/vibe-walking"
  mv -f "${temp_dir}/vibe-walking" "${install_dir}/"
)

# 检查 PATH
if [[ ":${PATH}:" != *":${install_dir}:"* ]]; then
  echo -e "\033[33mWarning: install dir '${install_dir}' not in \$PATH\033[0m"
  case "${SHELL}" in
    *"/zsh")
      echo -e "\033[33m         run \`echo 'export PATH=\"${install_dir}:\${PATH}\"' >> ~/.zshrc && source ~/.zshrc\` to add\033[0m"
    ;;
    *"/bash")
      echo -e "\033[33m         run \`echo 'export PATH=\"${install_dir}:\${PATH}\"' >> ~/.bashrc && source ~/.bashrc\` to add\033[0m"
    ;;
    *)
      echo -e "\033[33m         run \`export PATH=\"${install_dir}:\${PATH}\"\` to add\033[0m"
    ;;
  esac
fi

if [[ "${run}" == true ]]; then
  exec "${install_dir}/vibe-walking"
fi
