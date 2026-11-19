/* =========================================================================
   WhaleChat mobile shell (Expo / EAS)
   -------------------------------------------------------------------------
   The WhaleChat product is a single-page PWA (public/whalechat.html) with a
   service worker, IndexedDB device database, native canvas charts and the
   offline trade simulator. Rather than reimplement all of that in React
   Native, this shell loads the deployed app inside a WebView and keeps the
   same origin, so the service worker, storage and the Appwrite function
   transport all behave exactly as they do in the installed PWA.

   Everything is served from https://whalechat.appwrite.network — change
   `WEB_URL` (or app.json → expo.extra.webUrl) if the custom domain moves.

   Build:  npx eas build -p android --profile preview
           npx eas build -p ios --profile production
   ========================================================================= */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

/* EXPO_PUBLIC_* values are inlined at build time; no extra dependency needed */
const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || 'https://whalechat.appwrite.network/whalechat.html';

export default function App() {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && ref.current) { ref.current.goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#04101a" />
      {offline ? (
        <View style={styles.banner}><Text style={styles.bannerText}>Offline — showing the cached WhaleChat app</Text></View>
      ) : null}
      <WebView
        ref={ref}
        source={{ uri: WEB_URL }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        geolocationEnabled={false}
        cacheEnabled
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        applicationNameForUserAgent={'WhaleChatApp/3.65.0'}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onError={() => { setOffline(true); setLoading(false); }}
        onHttpError={() => setOffline(true)}
        onNavigationStateChange={(nav) => setCanGoBack(!!nav.canGoBack)}
        style={styles.web}
        pullToRefreshEnabled
        {...(Platform.OS === 'android' ? { androidLayerType: 'hardware' } : {})}
      />
      {loading ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="large" color="#2ee6c9" />
          <Text style={styles.loadingText}>WhaleChat</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04101a', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0 },
  web: { flex: 1, backgroundColor: '#04101a' },
  loading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#04101a' },
  loadingText: { marginTop: 12, color: '#2ee6c9', fontWeight: '800', letterSpacing: 1 },
  banner: { backgroundColor: '#3a2a05', borderBottomWidth: 1, borderBottomColor: '#f5b544', paddingVertical: 6 },
  bannerText: { color: '#ffd47a', fontSize: 11.5, fontWeight: '700', textAlign: 'center' }
});
