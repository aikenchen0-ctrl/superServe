# UniFFI以动态库导出名注册方法；先保留窄绑定命名空间，待真实R8/设备收据后再收窄。
-keep class org.superserve.playback.** { *; }
# JNA通过反射发现结构字段、回调和native入口。
-keep class com.sun.jna.** { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
