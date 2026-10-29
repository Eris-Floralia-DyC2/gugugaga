const ACCELERATOR = 'Control+T';
function createVisibilityShortcut({ shortcuts, showTopmost, hide, isShown, onError = () => {} }) {
  let registered = false;
  let shownByShortcut = false;
  let reason = '尚未启用';
  function toggle() {
    try {
      if (shownByShortcut && isShown()) {
        hide();
        shownByShortcut = false;
      } else {
        showTopmost();
        shownByShortcut = true;
      }
    } catch (error) {
      shownByShortcut = false;
      onError(error);
    }
  }
  function register() {
    if (registered) return true;
    try {
      registered = shortcuts.register(ACCELERATOR, () => {
        if (registered) toggle();
      });
      reason = registered ? '' : 'Ctrl+T 被其他程序占用或系统拒绝注册；释放该快捷键后重启 WS。';
    } catch {
      registered = false;
      reason = 'Ctrl+T 注册失败；请重启 WS 后重试。';
    }
    return registered;
  }
  function dispose() {
    if (registered) shortcuts.unregister(ACCELERATOR);
    registered = false;
    shownByShortcut = false;
    reason = '已释放';
  }
  return {
    register,
    dispose,
    toggle,
    status: () => ({ accelerator: 'Ctrl+T', registered, reason }),
  };
}
module.exports = { ACCELERATOR, createVisibilityShortcut };
