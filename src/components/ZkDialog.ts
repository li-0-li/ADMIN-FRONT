import { ElDialog } from 'element-plus';
import { defineComponent, h, ref } from 'vue';

/**
 * 全局接管 `el-dialog`，只补两件事：
 *   ① 关闭后把拖拽位移复位（下次打开回到屏幕中间）；
 *   ② 关闭按钮上按下鼠标不启动拖拽（点关闭时手一抖，弹窗会跟着挪）。
 *
 * 为什么不能在 main.ts 里监听关闭事件、直接清 `.el-dialog` 的 style.transform：
 *   Element Plus 的 useDraggable 把偏移量存在闭包里的 `transform.offsetX/offsetY`，
 *   拖拽时是 `offset + 鼠标位移` 算出来的。只清 DOM 内联样式，闭包里的旧 offset 还在，
 *   下次按住标题栏一动，弹窗会"跳"回上次拖到的位置再继续走。
 *   只有调组件 expose 的 `resetPosition()`（同时清 offset 和 style）才是真复位。
 *
 * 为什么在 `closed` 而不是 `close`：
 *   `close` 在动画起点触发，此时复位会让正在收起的弹窗瞬移回中间；
 *   `closed` 在过渡结束后触发，用户看到的是"关掉、下次打开在中间"。
 *
 * 透传：attrs 原样下发给 ElDialog（含 v-model 的 modelValue / onUpdate:modelValue、
 * before-close、append-to-body…），插槽同样透传；父组件若监听了 @closed / @opened，
 * 这里转发，不吞别人的回调。
 */
export default defineComponent({
  name: 'ElDialog',
  inheritAttrs: false,
  setup(_, { attrs, slots, expose }) {
    const inner = ref<InstanceType<typeof ElDialog> | null>(null);

    type DialogExposed = {
      resetPosition?: () => void;
      handleClose?: () => void;
      visible?: boolean;
      dialogContentRef?: { $el?: HTMLElement };
    };
    const inst = () => inner.value as unknown as DialogExposed | null;

    const resetPosition = () => inst()?.resetPosition?.();

    // 父组件传进来的 @opened / @closed 可能已被合并成数组（多个监听），两种形态都要处理
    const callParent = (key: 'onOpened' | 'onClosed') => {
      const fn = (attrs as Record<string, unknown>)[key];
      if (Array.isArray(fn)) fn.forEach((f) => typeof f === 'function' && (f as () => void)());
      else if (typeof fn === 'function') (fn as () => void)();
    };

    /**
     * 关闭按钮的 mousedown 不冒泡到标题栏，避免"点关闭"被当成"开始拖拽"。
     * EP 把拖拽监听绑在 .el-dialog__header 上（冒泡阶段），在按钮上拦一层即可。
     * 每次 opened 都查一遍：v-if 重建、append-to-body 换节点时守卫仍在。
     */
    const guardCloseButton = () => {
      const root = inst()?.dialogContentRef?.$el ?? (inner.value as unknown as { $el?: HTMLElement } | null)?.$el;
      const btn = root?.querySelector?.('.el-dialog__headerbtn') as HTMLElement | null;
      if (btn && btn.dataset.dragGuard !== '1') {
        btn.dataset.dragGuard = '1';
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
      }
    };

    const onOpened = () => {
      guardCloseButton();
      callParent('onOpened');
    };

    // 父组件可能 `<el-dialog ref="dlg">` 后调 handleClose()/resetPosition()，保持可用
    expose({
      resetPosition,
      handleClose: () => inst()?.handleClose?.(),
      get visible() {
        return inst()?.visible;
      },
      get dialogRef() {
        return inner.value;
      }
    });

    return () =>
      h(
        ElDialog,
        {
          ...attrs,
          ref: inner,
          onOpened,
          onClosed: () => {
            resetPosition();
            callParent('onClosed');
          }
        },
        slots
      );
  }
});
