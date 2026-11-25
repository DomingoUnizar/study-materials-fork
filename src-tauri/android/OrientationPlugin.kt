// 安卓全屏横屏：由 Rust 的 set_orientation 命令调用（见 src-tauri/src/api.rs）。
// 写法参照上游 Minireel/HGhub 的 src-tauri/android/OrientationPlugin.kt；
// 构建前由 scripts/sync-android-native.mjs 复制进 `tauri android init` 生成的工程。
//
// 同一个插件顺带处理「切后台回来白屏」：日志显示白屏时页面脚本和视频都在正常运行，
// 只是 WebView 没把画面画出来。回到前台后确认它真的画出了新的一帧，画不出来就让它重画一次，
// 过程写进播放诊断日志（见 src/playbackDiagnostics.ts 的 native.lifecycle）。
package com.hghub.huangguo

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.View
import android.webkit.WebView
import androidx.annotation.Keep
import org.json.JSONObject
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
@Keep
class OrientationArgs {
  var landscape: Boolean = false
}

@TauriPlugin
@Keep
class OrientationPlugin(private val activity: Activity) : Plugin(activity) {
  private var previousOrientation: Int? = null
  private var webView: WebView? = null
  private var resumeRound = 0L

  override fun load(webView: WebView) {
    super.load(webView)
    this.webView = webView
  }

  override fun onPause() = report("pause")

  override fun onStop() = report("stop")

  override fun onRestart() = report("restart")

  // 回到前台：postVisualStateCallback 在 WebView 真正画出当前页面时回调。1.5 秒内没回调，
  // 说明它没在出画面（就是白屏），把它隐藏再显示一次，让它重新出画面。正常时只多一次回调，没有别的动作。
  override fun onResume() {
    val wv = webView ?: return
    val round = ++resumeRound
    report("resume")
    wv.post {
      var drawn = false
      try {
        wv.postVisualStateCallback(round, object : WebView.VisualStateCallback() {
          override fun onComplete(requestId: Long) {
            drawn = true
            report("drawn")
          }
        })
      } catch (error: Throwable) {
        return@post
      }
      wv.postDelayed({
        if (drawn || round != resumeRound) return@postDelayed
        report("not_drawn")
        wv.visibility = View.INVISIBLE
        wv.post {
          wv.visibility = View.VISIBLE
          report("redraw_requested")
        }
      }, 1500)
    }
  }

  /** 原生生命周期和 WebView 状态交给页面写进播放诊断日志（没开诊断时页面那边直接忽略） */
  private fun report(phase: String) {
    val wv = webView ?: return
    val data = JSONObject()
      .put("phase", phase)
      .put("width", wv.width)
      .put("height", wv.height)
      .put("shown", wv.isShown)
      .put("attached", wv.isAttachedToWindow)
      .put("native_ms", System.currentTimeMillis())
    wv.post {
      try {
        wv.evaluateJavascript("window.__hgNativeLifecycle && window.__hgNativeLifecycle($data)", null)
      } catch (error: Throwable) {
        // 只是诊断，失败就算了
      }
    }
  }

  @Command
  fun setOrientation(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(OrientationArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message)
      return
    }
    activity.runOnUiThread {
      try {
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (args.landscape) {
          // 不受系统「自动旋转」开关影响，全屏期间固定横屏并隐藏状态栏/导航栏（边缘滑动可临时唤出）
          if (previousOrientation == null) previousOrientation = activity.requestedOrientation
          activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          insets.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          insets.hide(WindowInsetsCompat.Type.systemBars())
        } else if (previousOrientation != null) {
          activity.requestedOrientation = previousOrientation!!
          previousOrientation = null
          insets.show(WindowInsetsCompat.Type.systemBars())
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message)
      }
    }
  }
}
