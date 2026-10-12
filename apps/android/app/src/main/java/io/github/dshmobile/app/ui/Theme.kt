package io.github.dshmobile.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Brand = Color(0xFF2563EB)
private val BrandDark = Color(0xFF60A5FA)

private val Light = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    secondary = Color(0xFF0F766E),
    surfaceVariant = Color(0xFFF1F5F9),
    background = Color(0xFFFAFAFB),
)

private val Dark = darkColorScheme(
    primary = BrandDark,
    onPrimary = Color(0xFF0B1220),
    secondary = Color(0xFF5EEAD4),
    surfaceVariant = Color(0xFF23262D),
    background = Color(0xFF121418),
)

@Composable
fun DshMobileTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        content = content,
    )
}