// 启动器（普通脚本，在所有模块之前执行）：模块加载失败时给出提示。
// 模块加载失败会在 <script type="module"> 上触发 error（不冒泡，所以在捕获阶段监听）
window.addEventListener('error', function (e) {
  var t = e.target;
  if (t && t.tagName === 'SCRIPT' && document.body && document.body.classList.contains('booting')) {
    document.body.classList.add('boot-error');
  }
}, true);
