import { Tabs } from "expo-router";

import { colors } from "@/application/theme/theme";
import { CustomTabBar } from "@/navigation/components/custom-tab-bar/custom-tab-bar";

const TabsLayout = () => (
  <Tabs
    tabBar={(props) => <CustomTabBar {...props} />}
    screenOptions={{
      headerShown: false,
      sceneStyle: { backgroundColor: colors.background },
    }}
  >
    <Tabs.Screen name="index" />
    <Tabs.Screen name="history" />
    <Tabs.Screen name="profile" />
  </Tabs>
);

export default TabsLayout;
