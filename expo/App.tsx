import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || 'https://whalechat.appwrite.network/whalechat.html';

export default function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.bar}>
        <Text style={styles.brand}>🐋 WhaleChat</Text>
        <TouchableOpacity onPress={reload} style={styles.reload}>
          <Text style={styles.reloadText}>Reload</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.body}>
        <WebView
          ref={webRef}
          source={{ uri: WEB_URL }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          setSupportMultipleWindows={false}
          onLoadStart={() => { setError(null); setLoading(true); }}
          onLoadEnd={() => setLoading(false)}
          onError={(event) => { setLoading(false); setError(event.nativeEvent.description || 'Could not load WhaleChat'); }}
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode >= 400) {
              setLoading(false);
              setError('WhaleChat returned HTTP ' + event.nativeEvent.statusCode);
            }
          }}
          onMessage={() => undefined}
        />
        {loading && (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#34d3a6" />
            <Text style={styles.loading}>Connecting to WhaleChat…</Text>
          </View>
        )}
        {error && (
          <View style={styles.overlay}>
            <Text style={styles.errorTitle}>Connection problem</Text>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={reload} style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#04101a' },
  bar: { height: 42, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#071a27' },
  brand: { color: '#e8f4f8', fontSize: 15, fontWeight: '700' },
  reload: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(52,211,166,0.15)' },
  reloadText: { color: '#34d3a6', fontSize: 12, fontWeight: '600' },
  body: { flex: 1, backgroundColor: '#04101a' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#04101a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  loading: { color: '#8ba4b6', marginTop: 12, fontSize: 13 },
  errorTitle: { color: '#ff6b6b', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  errorText: { color: '#8ba4b6', textAlign: 'center', fontSize: 13, lineHeight: 20 },
  retry: { marginTop: 16, backgroundColor: '#34d3a6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 },
  retryText: { color: '#04101a', fontWeight: '700' },
});
