import { Image, ImageSource } from "expo-image";
import { StyleSheet } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";

import { useZoomableImageModel } from "@/history/model/use-zoomable-image-model";

interface ZoomableImageProps {
  source: ImageSource;
}

export const ZoomableImage = ({ source }: ZoomableImageProps) => {
  const { composedGesture, animatedStyle } = useZoomableImageModel();

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View style={[styles.container, animatedStyle]}>
        <Image source={source} style={styles.image} contentFit="contain" />
      </Animated.View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  image: { flex: 1 },
});
