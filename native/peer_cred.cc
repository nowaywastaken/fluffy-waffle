// native/peer_cred.cc
#include <napi.h>
#include <sys/socket.h>

#ifdef __linux__
#include <sys/types.h>
#endif

#ifdef __APPLE__
#include <sys/un.h>
#include <sys/ucred.h>
#endif

Napi::Value GetPeerCred(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected fd as number").ThrowAsJavaScriptException();
    return env.Null();
  }

  int fd = info[0].As<Napi::Number>().Int32Value();

#ifdef __linux__
  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0) {
    Napi::Error::New(env, "getsockopt(SO_PEERCRED) failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, static_cast<double>(cred.pid)));
  result.Set("uid", Napi::Number::New(env, static_cast<double>(cred.uid)));
  result.Set("gid", Napi::Number::New(env, static_cast<double>(cred.gid)));
  return result;

#elif defined(__APPLE__)
  struct xucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &cred, &len) < 0) {
    Napi::Error::New(env, "getsockopt(LOCAL_PEERCRED) failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  pid_t pid = 0;
  socklen_t pid_len = sizeof(pid);
  // LOCAL_PEEREPID available since macOS 10.14
  getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &pid, &pid_len);

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, static_cast<double>(pid)));
  result.Set("uid", Napi::Number::New(env, static_cast<double>(cred.cr_uid)));
  result.Set("gid", Napi::Number::New(env, static_cast<double>(cred.cr_groups[0])));
  return result;

#else
  Napi::Error::New(env, "Unsupported platform").ThrowAsJavaScriptException();
  return env.Null();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getPeerCred", Napi::Function::New(env, GetPeerCred));
  return exports;
}

NODE_API_MODULE(peer_cred, Init)
